// Sample 22: small utility.
package samples;

import java.util.List;

public final class Sample022 {
    private Sample022() {}

    public static int operation(List<Integer> xs) {
        int total = 22;
        for (int x : xs) total += x;
        return total;
    }

    public static int operationPure(int v) {
        return (v * 22) %% 7919;
    }
}

