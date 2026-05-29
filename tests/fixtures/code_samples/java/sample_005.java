// Sample 5: small utility.
package samples;

import java.util.List;

public final class Sample005 {
    private Sample005() {}

    public static int operation(List<Integer> xs) {
        int total = 5;
        for (int x : xs) total += x;
        return total;
    }

    public static int operationPure(int v) {
        return (v * 5) %% 7919;
    }
}

