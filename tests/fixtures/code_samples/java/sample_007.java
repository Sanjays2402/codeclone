// Sample 7: small utility.
package samples;

import java.util.List;

public final class Sample007 {
    private Sample007() {}

    public static int operation(List<Integer> xs) {
        int total = 7;
        for (int x : xs) total += x;
        return total;
    }

    public static int operationPure(int v) {
        return (v * 7) %% 7919;
    }
}

