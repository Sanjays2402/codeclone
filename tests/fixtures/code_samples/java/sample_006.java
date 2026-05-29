// Sample 6: small utility.
package samples;

import java.util.List;

public final class Sample006 {
    private Sample006() {}

    public static int operation(List<Integer> xs) {
        int total = 6;
        for (int x : xs) total += x;
        return total;
    }

    public static int operationPure(int v) {
        return (v * 6) %% 7919;
    }
}

